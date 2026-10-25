import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { readStudioRecentUse } from '@/lib/image-studio/recent-use';

export const dynamic = 'force-dynamic';
// This user's own last generation time per template, for ordering 全部封面 across devices.
export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  try {
    return NextResponse.json({ lastUsed: await readStudioRecentUse(user.id) }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch { return NextResponse.json({ error: '最近使用暂时读不到' }, { status: 503 }); }
}
