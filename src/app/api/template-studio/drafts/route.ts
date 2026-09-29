import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { createStudioDraft, listStudioDrafts } from '@/lib/template-studio/drafts';
import type { CreateStudioDraftRequest } from '@/lib/template-studio/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return withStudioRoute(async (user) => NextResponse.json(await listStudioDrafts(user, request.nextUrl.searchParams.get('cursor') || undefined)));
}

export async function POST(request: NextRequest) {
  return withStudioRoute(async (user) => {
    const draft = await createStudioDraft(user, await readStudioJson(request) as CreateStudioDraftRequest);
    return NextResponse.json({ draft }, { status: 201 });
  });
}
