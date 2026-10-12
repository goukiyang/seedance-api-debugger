import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listStudioModules, saveStudioModule, deleteStudioModule, deleteStudioGroup, studioModuleDTOForUser, StudioModuleError } from '@/lib/image-studio/modules';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { openSharedStudioModule, StudioSharingError } from '@/lib/image-studio/shared-contract';
import { StudioStyleError } from '@/lib/image-studio/style-groups';
import { StudioFixedReferenceError } from '@/lib/image-studio/fixed-references';
import { StudioReferencePolicyError } from '@/lib/image-studio/reference-policy';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function businessError(error: unknown) {
  return error instanceof StudioModuleError || error instanceof StudioSharingError || error instanceof StudioStyleError || error instanceof StudioFixedReferenceError || error instanceof StudioReferencePolicyError;
}
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用图片模板' }, { status: 403 });
  const idsValue = request.nextUrl.searchParams.get('ids');
  const ids = idsValue ? Array.from(new Set(idsValue.split(','))) : undefined;
  if (ids && (ids.length > 12 || ids.some(id => !id || id.length > 100))) return NextResponse.json({ error: '模块读取参数无效' }, { status: 400 });
  try { return NextResponse.json(await listStudioModules(user.id, request.nextUrl.searchParams.get('cursor') || undefined, user.role === 'admin', ids, user), { headers: privateHeaders }); }
  catch (error) {
    if (businessError(error)) return NextResponse.json({ error: (error as StudioModuleError).message }, { status: (error as StudioModuleError).status, headers: privateHeaders });
    return NextResponse.json({ error: '模块读取失败，请重试' }, { status: 503, headers: privateHeaders });
  }
}
async function save(request: NextRequest, createOnly: boolean) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用图片模板' }, { status: 403 });
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: '模块内容无效' }, { status: 400, headers: privateHeaders });
    if (createOnly && body.action === 'open-shared') {
      if (typeof body.presetId !== 'string' || !body.presetId || body.presetId.length > 160) return NextResponse.json({ error: '共享模板编号无效' }, { status: 400, headers: privateHeaders });
      const workspace = await openSharedStudioModule(user, body.presetId, body.requestId);
      return NextResponse.json(await studioModuleDTOForUser(user, workspace.id), { headers: privateHeaders });
    }
    return NextResponse.json(await saveStudioModule(user.id, body, createOnly, user.role === 'admin', undefined, user), { headers: privateHeaders });
  }
  catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: '模块内容无效' }, { status: 400 });
    if (businessError(error)) return NextResponse.json({ error: (error as StudioModuleError).message }, { status: (error as StudioModuleError).status, headers: privateHeaders });
    return NextResponse.json({ error: '保存未确认，草稿仍保留，请重试' }, { status: 503 });
  }
}
export const POST = (request: NextRequest) => save(request, true);
export const PUT = (request: NextRequest) => save(request, false);

export async function DELETE(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '无权操作图片模板' }, { status: 403 });
  try {
    const body = await request.json();
    if (body?.action === 'delete-group') return NextResponse.json(await deleteStudioGroup(user, body), { headers: privateHeaders });
    await deleteStudioModule(user.id, body?.id, body?.revision);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (businessError(error)) return NextResponse.json({ error: (error as StudioModuleError).message }, { status: (error as StudioModuleError).status, headers: privateHeaders });
    if (error instanceof SyntaxError) return NextResponse.json({ error: '模板参数无效' }, { status: 400 });
    return NextResponse.json({ error: '删除未确认，请重试' }, { status: 503 });
  }
}
