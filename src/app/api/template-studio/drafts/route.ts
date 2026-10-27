import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { createStudioDraft, listStudioDrafts } from '@/lib/template-studio/drafts';
import type { CreateStudioDraftRequest } from '@/lib/template-studio/types';

export const dynamic = 'force-dynamic';

export const GET = declaredRoute({ access: 'internal', rateLimit: false }, async function GET(request: NextRequest) {
  return withStudioRoute(async (user) => NextResponse.json(await listStudioDrafts(user, request.nextUrl.searchParams.get('cursor') || undefined)));
});

export const POST = declaredRoute({ access: 'internal', rateLimit: false }, async function POST(request: NextRequest) {
  return withStudioRoute(async (user) => {
    const draft = await createStudioDraft(user, await readStudioJson(request) as CreateStudioDraftRequest);
    return NextResponse.json({ draft }, { status: 201 });
  });
});
