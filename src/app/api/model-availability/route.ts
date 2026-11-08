import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPricingModelAvailability } from '@/lib/pricing/policy';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const user = await getSession();
  const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  if (request.headers.get('x-app-session-user') && request.headers.get('x-app-session-user') !== user.id) {
    return NextResponse.json({ error: '账号已变化，请重新读取模型状态' }, { status: 409, headers });
  }
  try { return NextResponse.json(await getPricingModelAvailability(), { headers }); }
  catch { return NextResponse.json({ error: '模型开放状态暂时无法读取，请重试；当前输入已保留' }, { status: 503, headers }); }
}
