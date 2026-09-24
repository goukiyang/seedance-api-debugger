import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listStudioModules, saveStudioModule, StudioModuleError } from '@/lib/image-studio/modules';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用图片模板' }, { status: 403 });
  try { return NextResponse.json(await listStudioModules(user.id, request.nextUrl.searchParams.get('cursor') || undefined, user.role === 'admin'), { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: '模块读取失败，请重试' }, { status: 503 }); }
}
async function save(request: NextRequest, createOnly: boolean) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用图片模板' }, { status: 403 });
  try { return NextResponse.json(await saveStudioModule(user.id, await request.json(), createOnly, user.role === 'admin')); }
  catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: '模块内容无效' }, { status: 400 });
    if (error instanceof StudioModuleError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: '保存未确认，草稿仍保留，请重试' }, { status: 503 });
  }
}
export const POST = (request: NextRequest) => save(request, true);
export const PUT = (request: NextRequest) => save(request, false);
