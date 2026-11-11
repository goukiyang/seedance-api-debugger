import { NextRequest } from 'next/server';
import { CharacterAssetError } from '@/lib/character-assets/errors';
import { registerCharacterThumbnail } from '@/lib/character-assets/service';
import { readCharacterAssetBody, withCharacterAssetUser } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return withCharacterAssetUser(request, async user => {
    const body = await readCharacterAssetBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'assetId')) {
      throw new CharacterAssetError('缩略图登记输入无效，请保留原文件后重试', 400, 'CHARACTER_THUMBNAIL_INVALID');
    }
    return registerCharacterThumbnail(user, body.assetId);
  });
}
