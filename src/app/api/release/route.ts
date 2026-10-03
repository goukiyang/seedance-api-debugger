import { NextResponse } from 'next/server';
import { release } from '@/lib/release';
import { getSession } from '@/lib/auth/session';
export const dynamic = 'force-dynamic';
export async function GET() {
  const user = await getSession();
  return NextResponse.json({ ...release, summary: user?.account_type === 'internal' ? release.summary : '' }, {
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}
