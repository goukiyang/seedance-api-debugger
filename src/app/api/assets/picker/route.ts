import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { PaginationError } from '@/lib/pagination/cursor';
import { readPicker } from '@/lib/assets/picker-service';

export const dynamic = 'force-dynamic';

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    return NextResponse.json(await readPicker(user, request.nextUrl.searchParams, request.headers), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return error instanceof PaginationError ? NextResponse.json({ error: error.message }, { status: error.status }) : apiErrorResponse(error);
  }
});
