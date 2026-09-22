import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { applyStudioPreset, listStudioPresets, saveStudioPreset } from '@/lib/image-studio/presets';
import { StudioModuleError } from '@/lib/image-studio/modules';

export const dynamic = 'force-dynamic';
export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  return NextResponse.json({ presets: await listStudioPresets(user.id, user.role === 'admin') }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    const body = await request.json();
    if (body.action === 'apply') return NextResponse.json(await applyStudioPreset(user.id, String(body.presetId || ''), user.role === 'admin'));
    return NextResponse.json(await saveStudioPreset(user.id, body, user.role === 'admin'));
  } catch (error) {
    if (error instanceof StudioModuleError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: '模板操作失败，请重试' }, { status: 503 });
  }
}
