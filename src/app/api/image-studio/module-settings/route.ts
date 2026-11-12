import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canAccessImageTemplates } from '@/lib/image-studio/access';
import { listStudioModuleSettings, saveStudioModuleSettings, studioModuleSettingsStatus, StudioModuleSettingsError } from '@/lib/image-studio/module-settings';
import { StudioSharingError } from '@/lib/image-studio/shared-contract';
import { StudioStyleError } from '@/lib/image-studio/style-groups';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function failure(error: unknown) {
  if (error instanceof StudioModuleSettingsError || error instanceof StudioSharingError || error instanceof StudioStyleError) {
    return NextResponse.json({ error: error.message, commandOutcome: (error as { commandOutcome?: unknown }).commandOutcome }, { status: error.status, headers });
  }
  return NextResponse.json({ error: '设置操作结果未确认，请核对原保存' }, { status: 503, headers });
}
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  if (!canAccessImageTemplates(user)) return NextResponse.json({ error: '无权使用模板设置' }, { status: 403, headers });
  try {
    const moduleId = request.nextUrl.searchParams.get('moduleId') || '';
    const requestId = request.nextUrl.searchParams.get('requestId');
    return NextResponse.json(requestId ? await studioModuleSettingsStatus(user, moduleId, requestId)
      : await listStudioModuleSettings(user, moduleId, request.nextUrl.searchParams.get('id') ?? undefined), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  if (!canAccessImageTemplates(user)) return NextResponse.json({ error: '无权使用模板设置' }, { status: 403, headers });
  try { return NextResponse.json(await saveStudioModuleSettings(user, await request.json()), { headers }); }
  catch (error) { return failure(error); }
}
