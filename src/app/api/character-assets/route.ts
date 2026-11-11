import { NextRequest } from 'next/server';
import { createCharacterAsset, listCharacterAssets } from '@/lib/character-assets/service';
import { readCharacterAssetBody, withCharacterAssetUser } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return withCharacterAssetUser(request, async user => ({ assets: await listCharacterAssets(user, {
    includeDeleted: request.nextUrl.searchParams.get('includeDeleted') === '1',
    q: request.nextUrl.searchParams.get('q') || undefined,
  }) }));
}

export async function POST(request: NextRequest) {
  return withCharacterAssetUser(request, async user => ({ asset: await createCharacterAsset(user, await readCharacterAssetBody(request)) }), 201);
}
