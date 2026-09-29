import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { getStudioDraft, updateStudioDraft } from '@/lib/template-studio/drafts';
import type { UpdateStudioDraftRequest } from '@/lib/template-studio/types';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async (user) => NextResponse.json({ draft: await getStudioDraft(user, params.id) }));
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async (user) => {
    const draft = await updateStudioDraft(user, params.id, await readStudioJson(request) as UpdateStudioDraftRequest);
    return NextResponse.json({ draft });
  });
}
