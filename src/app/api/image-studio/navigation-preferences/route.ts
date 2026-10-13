import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { changeStudioNavigationPreference, readStudioNavigationPreference, StudioNavigationPreferenceError } from '@/lib/image-studio/navigation-preferences';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function failure(cause: unknown) {
  if (cause instanceof StudioNavigationPreferenceError) return NextResponse.json({ error: cause.message }, { status: cause.status, headers });
  return NextResponse.json({ error: '侧栏设置未能确认，请重新读取；模块和历史仍保留' }, { status: 503, headers });
}
export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '无权使用图片模板' }, { status: 403, headers });
  try { return NextResponse.json({ viewerId: user.id, preference: await readStudioNavigationPreference(user.id) }, { headers }); }
  catch (cause) { return failure(cause); }
}
export async function PATCH(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  if (!canUseCompanyTemplates(user)) return NextResponse.json({ error: '无权使用图片模板' }, { status: 403, headers });
  if (request.headers.get('origin') !== new URL(request.url).origin) return NextResponse.json({ error: '请求来源无效' }, { status: 403, headers });
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.viewerId !== user.id) return NextResponse.json({ error: '账号已变化，请重新登录后再操作' }, { status: 403, headers });
    const preference = await prisma.$transaction(client => changeStudioNavigationPreference(client, user.id, body.moduleId, body.hidden, body.expectedRevision));
    return NextResponse.json({ viewerId: user.id, preference }, { headers });
  } catch (cause) {
    if (cause instanceof SyntaxError) return NextResponse.json({ error: '侧栏设置参数无效' }, { status: 400, headers });
    return failure(cause);
  }
}
