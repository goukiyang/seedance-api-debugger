import { NextRequest } from 'next/server';
import { deleteCharacterAsset, getCharacterAsset, updateCharacterAsset } from '@/lib/character-assets/service';
import { CharacterAssetError } from '@/lib/character-assets/errors';
import { readCharacterAssetBody, withCharacterAssetUser } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withCharacterAssetUser(request, async user => ({ asset: await getCharacterAsset(user, params.id) }));
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  return withCharacterAssetUser(request, async user => ({ asset: await updateCharacterAsset(user, params.id, await readCharacterAssetBody(request)) }));
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  return withCharacterAssetUser(request, async user => {
    const body = await readCharacterAssetBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'revision')) {
      throw new CharacterAssetError('删除记录需提供当前 revision', 400, 'CHARACTER_ASSET_INVALID_BODY');
    }
    return { asset: await deleteCharacterAsset(user, params.id, body.revision) };
  });
}
