import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { getCanvasTextSettings, saveCanvasTextSettings } from '@/lib/canvas-text-settings';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
function failure(error: unknown) {
  if (error instanceof AuthError) return json({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return json({ error: '规则内容无效' }, 400);
  return json({ error: '规则暂时无法保存或读取，草稿仍保留，请重试' }, 503);
}

export async function GET() {
  try {
    const user = await getSession();
    if (!user) throw new AuthError('请先登录', 401);
    assertInternalOnly(user, '外部账号无权使用画布规则');
    const settings = await getCanvasTextSettings();
    return json({ revision: settings.revision, contextConfigured: Boolean(settings.context.trim()),
      ...(user.role === 'admin' ? { context: settings.context } : {}) });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    assertInternalOnly(user, '外部账号无权修改画布规则');
    if (Number(request.headers.get('content-length')) > 64 * 1024) throw new AuthError('规则内容过大', 413);
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) throw new AuthError('规则内容过大', 413);
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.context !== 'string' || body.context.length > 4000
      || !Number.isSafeInteger(body.revision) || body.revision < 0
      || (body.confirmClear !== undefined && typeof body.confirmClear !== 'boolean')) {
      throw new AuthError('规则最多4000字，请检查内容后保存', 400);
    }
    return json(await saveCanvasTextSettings(user.id, { context: body.context.trim(), revision: body.revision }, body.confirmClear === true));
  } catch (error) { return failure(error); }
}
