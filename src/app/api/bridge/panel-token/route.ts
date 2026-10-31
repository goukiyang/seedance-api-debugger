import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, getSessionByToken } from '@/lib/auth/session';
import { isAllowedShellOrigin, issuePanelToken } from '@/lib/bridge/panel-token';

export const dynamic = 'force-dynamic';

/** 插件 SW 调用：POST，带 session Cookie + X-SD2B-Shell 头，Origin 必须是扩展 */
export async function POST(request: NextRequest) {
  try {
    if (!request.headers.get('x-sd2b-shell') || !isAllowedShellOrigin(request.headers.get('origin'))) {
      return NextResponse.json({ error: '来源不允许', ok: false }, { status: 403 });
    }
    const session = request.cookies.get(SESSION_COOKIE)?.value || '';
    const user = session ? await getSessionByToken(session) : null;
    if (!user) return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
    let deviceId = '';
    try {
      const body = await request.json();
      deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
    } catch {
      deviceId = '';
    }
    const { token, expiresAt } = issuePanelToken(session, deviceId);
    return NextResponse.json(
      { ok: true, token, expiresAt, user: { id: user.id, name: user.name, avatar_url: user.avatar_url || null } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[bridge/panel-token]', error);
    return NextResponse.json({ error: '签发失败', ok: false }, { status: 500 });
  }
}
