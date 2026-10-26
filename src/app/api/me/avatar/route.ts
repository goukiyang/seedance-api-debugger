import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AvatarError, restoreAvatar, setCustomAvatar } from '@/lib/avatar';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
// { action: 'custom', assetId, crop } | { action: 'feishu' | 'initials' } | { action: 'admin-reset', userId } (admin → Feishu photo)
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin || new URL(origin).host !== (request.headers.get('x-forwarded-host') || request.headers.get('host'))) return NextResponse.json({ error: '请求来源无效' }, { status: 403, headers });
  const user = await getSession();
  if (!user || user.status !== 'active') return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (body?.action === 'custom') return NextResponse.json(await setCustomAvatar(user.id, body.assetId, body.crop), { headers });
    if (body?.action === 'feishu' || body?.action === 'initials') return NextResponse.json(await restoreAvatar(user, user.id, body.action), { headers });
    if (body?.action === 'admin-reset' && typeof body.userId === 'string') return NextResponse.json(await restoreAvatar(user, body.userId, 'feishu'), { headers });
    return NextResponse.json({ error: '操作无效' }, { status: 400, headers });
  } catch (error) {
    if (error instanceof AvatarError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    return NextResponse.json({ error: '头像暂未保存，请重试' }, { status: 503, headers });
  }
}
