import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { cancelStudioRun, getStudioRun } from '@/lib/template-studio/runs';
import type { CancelStudioRunRequest } from '@/lib/template-studio/types';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async (user) => NextResponse.json(await getStudioRun(user, params.id)));
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async (user) => {
    const body = await readStudioJson(request) as CancelStudioRunRequest;
    if (!body || body.action !== 'cancel') {
      return NextResponse.json({ error: '不支持的运行操作', code: 'INVALID' }, { status: 400 });
    }
    return NextResponse.json({ run: await cancelStudioRun(user, params.id) });
  });
}
