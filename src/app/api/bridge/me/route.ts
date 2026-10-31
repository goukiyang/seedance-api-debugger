import { NextRequest, NextResponse } from 'next/server';
import { getBridgeUser } from '@/lib/bridge/panel-token';

export const dynamic = 'force-dynamic';

/** 浮窗工作台用：令牌换当前用户基本信息 */
export async function GET(request: NextRequest) {
  const user = await getBridgeUser(request);
  if (!user) return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
  return NextResponse.json(
    { ok: true, user: { id: user.id, name: user.name, role: user.role, avatar_url: user.avatar_url || null } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
