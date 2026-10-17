import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { MultiviewPresetError, readMultiviewRotationPreset, readMultiviewPresetSaveReceipt,
  saveMultiviewRotationPreset } from '@/lib/video/multiview-preset.server';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
function failure(error: unknown) {
  if (error instanceof AuthError || error instanceof MultiviewPresetError) return NextResponse.json({ error: error.message,
    ...(error instanceof MultiviewPresetError ? { code: error.code } : {}) }, { status: error.status, headers });
  return NextResponse.json({ error: '模板提示词操作结果暂时无法确认，请保留输入并查询原保存编号。',
    code: 'MULTIVIEW_PRESET_SAVE_UNKNOWN' }, { status: 503, headers });
}
async function admin(request: NextRequest) {
  const user = await getAdminUser(request);
  if (user.status !== 'active') throw new AuthError('账号已被禁用', 403);
  assertInternalOnly(user);
  return user;
}
export async function GET(request: NextRequest) {
  try {
    const user = await admin(request);
    const mutationId = request.nextUrl.searchParams.get('mutationId');
    if (mutationId !== null) {
      const saved = await readMultiviewPresetSaveReceipt(user.id, mutationId);
      return NextResponse.json(saved?.receipt || { state: 'not_found', mutationId }, { headers });
    }
    return NextResponse.json(await readMultiviewRotationPreset(), { headers });
  } catch (error) { return failure(error); }
}
export async function PUT(request: NextRequest) {
  try {
    const user = await admin(request);
    let body: unknown;
    try { body = await request.json(); } catch { throw new MultiviewPresetError('保存内容无法读取，请保留输入。'); }
    return NextResponse.json(await saveMultiviewRotationPreset(body, user.id), { headers });
  } catch (error) { return failure(error); }
}
