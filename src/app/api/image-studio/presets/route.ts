import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { applyStudioPreset, canUseCompanyTemplates, linkStudioQuickPreset, listStudioPresets, manageStudioPreset, saveStudioPreset, setStudioPresetSharing } from '@/lib/image-studio/presets';
import { StudioModuleError } from '@/lib/image-studio/modules';
import { StudioStyleError } from '@/lib/image-studio/style-groups';
import { StudioSharingError } from '@/lib/image-studio/shared-contract';
import { StudioFixedReferenceError } from '@/lib/image-studio/fixed-references';
import { StudioReferencePolicyError } from '@/lib/image-studio/reference-policy';
import { ModuleCoverError } from '@/lib/image-studio/module-cover';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用共享模板' }, { status: 403 });
  try {
    const moduleId = request.nextUrl.searchParams.get('moduleId') ?? undefined;
    const presetId = request.nextUrl.searchParams.get('presetId') ?? undefined;
    if (presetId && presetId.length > 160) return NextResponse.json({ error: '模板读取参数无效' }, { status: 400, headers: privateHeaders });
    return NextResponse.json({ presets: await listStudioPresets(user, moduleId, presetId) }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof StudioModuleError || error instanceof StudioStyleError || error instanceof StudioSharingError || error instanceof StudioFixedReferenceError || error instanceof StudioReferencePolicyError || error instanceof ModuleCoverError) return NextResponse.json({ error: error.message }, { status: error.status, headers: privateHeaders });
    return NextResponse.json({ error: '模板读取失败，请重试' }, { status: 503 });
  }
}
export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用共享模板' }, { status: 403 });
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: '模板内容无效' }, { status: 400, headers: privateHeaders });
    if (body.action === 'rename' || body.action === 'delete') return NextResponse.json(await manageStudioPreset(user, String(body.presetId || ''), body.revision, body.action, body.name));
    if (body.action === 'replace') return NextResponse.json(await saveStudioPreset(user, body, true));
    if (body.action === 'add-quick') return NextResponse.json(await linkStudioQuickPreset(user, String(body.moduleId || ''), String(body.presetId || '')));
    if (body.action === 'apply') return NextResponse.json(await applyStudioPreset(user, String(body.presetId || '')));
    if (body.action === 'set-sharing') {
      if (typeof body.isShared !== 'boolean') return NextResponse.json({ error: '模板共享设置无效' }, { status: 400, headers: privateHeaders });
      const updated = await setStudioPresetSharing(user, String(body.presetId || ''), body.isShared, body.revision);
      return NextResponse.json({ id: updated.id, isShared: updated.is_shared });
    }
    return NextResponse.json(await saveStudioPreset(user, body));
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: '模板内容无效' }, { status: 400, headers: privateHeaders });
    if (error instanceof StudioModuleError || error instanceof StudioStyleError || error instanceof StudioSharingError || error instanceof StudioFixedReferenceError || error instanceof StudioReferencePolicyError || error instanceof ModuleCoverError) return NextResponse.json({ error: error.message }, { status: error.status, headers: privateHeaders });
    return NextResponse.json({ error: '模板操作失败，请重试' }, { status: 503 });
  }
}
