import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { cancelStudioRun, getStudioRun } from '@/lib/template-studio/runs';
import type { CancelStudioRunRequest } from '@/lib/template-studio/types';

export const dynamic = 'force-dynamic';

export const GET = declaredRoute({ access: 'internal', rateLimit: false }, async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return withStudioRoute(async (user) => NextResponse.json(await getStudioRun(user, params.id)));
});

export const POST = declaredRoute({ access: 'internal', rateLimit: false }, async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  return withStudioRoute(async (user) => {
    const body = await readStudioJson(request) as CancelStudioRunRequest;
    if (!body || body.action !== 'cancel') {
      return NextResponse.json({ error: '不支持的运行操作', code: 'INVALID' }, { status: 400 });
    }
    return NextResponse.json({ run: await cancelStudioRun(user, params.id) });
  });
});
