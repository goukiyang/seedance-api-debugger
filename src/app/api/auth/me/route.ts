import { route as apiRoute } from '@/lib/http/route';
import { NextResponse } from 'next/server';
import { getSession, SessionUnavailableError } from '@/lib/auth/session';

export const GET = apiRoute({ access: 'public', rateLimit: false }, async function GET() {
  try {
    const user = await getSession();
    return NextResponse.json({ user }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (!(error instanceof SessionUnavailableError)) throw error;
    return NextResponse.json({ error: '服务暂时不可用', code: error.code }, { status: 503, headers: { 'Retry-After': '2', 'Cache-Control': 'private, no-store' } });
  }
});
