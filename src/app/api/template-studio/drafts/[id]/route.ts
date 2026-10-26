import { NextRequest, NextResponse } from 'next/server';
import { withStudioRoute, readStudioJson } from '@/lib/template-studio/common';
import { getStudioDraft, updateStudioDraft } from '@/lib/template-studio/drafts';
import { getStudioReferenceMetadata } from '@/lib/template-studio/assets';
import type { UpdateStudioDraftRequest } from '@/lib/template-studio/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async (user) => {
    const draft = await getStudioDraft(user, params.id);
    if (request.nextUrl.searchParams.has('assetIds')) {
      const assetIds = request.nextUrl.searchParams.getAll('assetIds').flatMap(value => value.split(','));
      const assets = await getStudioReferenceMetadata(user, assetIds);
      return NextResponse.json({ assets }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    }
    return NextResponse.json({ draft });
  });
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  return withStudioRoute(async (user) => {
    const draft = await updateStudioDraft(user, params.id, await readStudioJson(request) as UpdateStudioDraftRequest);
    return NextResponse.json({ draft });
  });
}
