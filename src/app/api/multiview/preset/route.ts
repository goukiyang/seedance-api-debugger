import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { MultiviewPresetError, readPublicMultiviewRotationPreset, multiviewPrivateOrigins } from '@/lib/video/multiview-preset.server';
import { privatePromptRequestCapabilities } from '@/lib/security/private-prompt-request.server';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (user.status !== 'active') throw new AuthError('账号已被禁用', 403);
    assertInternalOnly(user, '外部账号无权使用3D多视图生成。');
    return NextResponse.json({ ...await readPublicMultiviewRotationPreset(),
      ...await privatePromptRequestCapabilities(user.id, multiviewPrivateOrigins()) }, { headers: { ...headers, Vary: 'Cookie' } });
  } catch (error) {
    if (error instanceof AuthError || error instanceof MultiviewPresetError) return NextResponse.json({ error: error.message,
      ...(error instanceof MultiviewPresetError ? { code: error.code } : {}) }, { status: error.status, headers });
    return NextResponse.json({ error: '模板提示词暂时无法读取，请稍后重试。' }, { status: 503, headers });
  }
}
