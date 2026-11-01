import { headers as requestHeaders } from 'next/headers';
import { traceHttpRequest, tracePhase } from '@/lib/performance/request-trace';
import { NextResponse } from 'next/server';
import { release } from '@/lib/release';
import { getSession } from '@/lib/auth/session';
export const dynamic = 'force-dynamic';
export async function GET() {
  return traceHttpRequest('release.read', requestHeaders(), async () => {
  const user = await tracePhase('auth', () => getSession());
  const internal = user?.account_type === 'internal';
  return NextResponse.json({ ...release, summary: internal ? release.summary : '', title: internal ? release.title : '', outline: internal ? release.outline : [] }, {
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
  });
}
