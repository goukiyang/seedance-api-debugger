import { route as apiRoute } from '@/lib/http/route';
import { NextResponse } from 'next/server';
import { release } from '@/lib/release';
import { getSession } from '@/lib/auth/session';
export const dynamic = 'force-dynamic';
export const GET = apiRoute({ access: 'public', rateLimit: false }, async function GET() {
  const user = await getSession();
  const internal = user?.account_type === 'internal';
  return NextResponse.json({ ...release, summary: internal ? release.summary : '', title: internal ? release.title : '', outline: internal ? release.outline : [] }, {
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
});
