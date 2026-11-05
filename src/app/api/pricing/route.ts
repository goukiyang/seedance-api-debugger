import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { getPricingGuideSnapshot } from '@/lib/pricing/policy';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    const owner = request.headers.get('x-app-session-user');
    if (owner && owner !== user.id) throw new AuthError('账号已变化，请重新打开费率说明', 409);
    return NextResponse.json({ actorId: user.id, pricing: await getPricingGuideSnapshot(user) }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    return NextResponse.json({ error: '暂时无法读取费率，请重试' }, { status: 503, headers });
  }
}
