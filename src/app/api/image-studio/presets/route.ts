import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { applyStudioPreset, canUseCompanyTemplates, listStudioPresets, saveStudioPreset, setStudioPresetSharing } from '@/lib/image-studio/presets';
import { StudioModuleError } from '@/lib/image-studio/modules';

export const dynamic = 'force-dynamic';
export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用共享模板' }, { status: 403 });
  return NextResponse.json({ presets: await listStudioPresets(user) }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '仅限公司飞书账号使用共享模板' }, { status: 403 });
  try {
    const body = await request.json();
    if (body.action === 'apply') return NextResponse.json(await applyStudioPreset(user, String(body.presetId || '')));
    if (body.action === 'set-sharing') {
      if (user.role !== 'admin') return NextResponse.json({ error: '只有管理员可以修改模板共享状态' }, { status: 403 });
      const updated = await setStudioPresetSharing(user, String(body.presetId || ''), body.isShared === true);
      return NextResponse.json({ id: updated.id, isShared: updated.is_shared });
    }
    return NextResponse.json(await saveStudioPreset(user, body));
  } catch (error) {
    if (error instanceof StudioModuleError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: '模板操作失败，请重试' }, { status: 503 });
  }
}
